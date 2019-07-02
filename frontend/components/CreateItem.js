import React, { Component } from 'react';
import { Mutation } from 'react-apollo';
import gql from 'graphql-tag';
import Router from 'next/router';
import Form from './styles/Form';
import formatMoney from '../lib/formatMoney';
import Error from './ErrorMessage';

// the actual mutation uses $variables passed from the React client
const CREATE_ITEM_MUTATION = gql`
    mutation CREATE_ITEM_MUTATION (
            $title: String!
            $description: String!
            $price: Int!
            $image: String
            $largeImage: String
    ) {
        createItem(
            title: $title
            description: $description
            price: $price
            image: $image
            largeImage: $largeImage
        ) {
            id
        }
    }
`;

class CreateItem extends Component {
    state = {
        title: '',
        description: '',
        image: '',
        largeImage: '',
        price: 0
    };

    handleChange = e => {
        const { name, type, value } = e.target;
        const val = type === 'number' ? parseFloat(value) : value;
        this.setState({ [name]: val })
    }

    uploadFile = async e => {
        console.log('Uploading')
        const files = e.target.files;
        const data = new FormData();
        data.append('file', files[0]);
        data.append('upload_preset', 'lz59twu8');

        const res = await fetch('https://api.cloudinary.com/v1_1/de6prxoay/image/upload', {
            method: 'POST',
            body: data 
        })

        // parse the response to state (image receives cloudinary 'incoming' transformation and largeImage the 'eager' transformation)
        const file = await res.json();
        this.setState({
            image: file.secure_url,
            largeImage: file.eager[0].secure_url
        })
    }

    render() {
        return (
            <Mutation mutation={CREATE_ITEM_MUTATION} variables={this.state}>
                {(createItem, { loading, error }) => (
                    <Form onSubmit={async e => {
                        // stop the form from submitting
                        e.preventDefault();

                        // call the mutation
                        const res = await createItem();

                        // change the user to the single item page
                        Router.push({
                            pathname: '/item',
                            query: { id: res.data.createItem.id }
                        })
                    }}>
                        <Error error={error} />
                        <fieldset disabled={loading} aria-busy={loading}>
                            <label htmlFor="file">
                                Image
                                <input
                                    type="file"
                                    id="file"
                                    name="file"
                                    placeholder="Upload an image" 
                                    required
                                    onChange={this.uploadFile}
                                />
                                {this.state.image && <img width="200" src={this.state.image} alt="Upload preview" />}
                            </label>

                            <label htmlFor="title">
                                title
                                <input
                                    type="text"
                                    id="title"
                                    name="title"
                                    placeholder="Title" 
                                    required
                                    value={this.state.title}
                                    onChange={this.handleChange}
                                />
                            </label>

                            <label htmlFor="price">
                                price
                                <input
                                    type="number"
                                    id="price"
                                    name="price"
                                    placeholder="Price" 
                                    required
                                    value={this.state.price}
                                    onChange={this.handleChange}
                                />
                            </label>

                            <label htmlFor="description">
                                Description
                                <textarea
                                    type="number"
                                    id="description"
                                    name="description"
                                    placeholder="Enter a Description" 
                                    required
                                    value={this.state.description}
                                    onChange={this.handleChange}
                                />
                            </label>
                            <button type="submit">Submit</button>
                        </fieldset>
                    </Form>
                )}    
            </Mutation>
        );
    }
}

export default CreateItem;
export { CREATE_ITEM_MUTATION };